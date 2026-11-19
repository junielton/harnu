import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  acHash,
  checkAtomCoverage,
  checkCapabilityOrder,
  checkSpecFile,
  parseSpec
} from '../resources/skills/skills/spec/scripts/spec-check-core.mjs'
import * as ciGate from '../scripts/ci/spec-gate-core.mjs'
import * as vendoredGate from '../resources/skills/skills/spec/scripts/spec-gate-core.mjs'

/**
 * `spec check` (T601 S-1): the dependency-free checker vendored inside the skill directory.
 * `parseSpec` reads the template shape into atoms, slices, ACs, decisions and card rows; the
 * gate's rules run on it as if the draft were approved, then two checks the gate cannot make:
 * capability order (a slice must not precede the slice that produces what it consumes) and
 * request-atom coverage (every R-n lands on an AC, a non-goal or a decision).
 */

const ROOT = resolve(__dirname, '..')
const SCRIPTS = join(ROOT, 'resources/skills/skills/spec/scripts')
const CLI = join(SCRIPTS, 'spec-check.mjs')
const FIX = join(ROOT, 'tests/fixtures/spec-check')
const fixture = (name: string): string => readFileSync(join(FIX, name), 'utf8')

type Finding = { line: number; rule: string; message: string }

/** 1-based line of the first line containing `needle`. */
const lineOf = (content: string, needle: string): number => {
  const idx = content.split('\n').findIndex((l) => l.includes(needle))
  if (idx === -1) throw new Error(`fixture has no line containing ${needle}`)
  return idx + 1
}

const ruleSet = (findings: Finding[]): string[] => findings.map((f) => f.rule)

describe('parseSpec', () => {
  const parsed = parseSpec(fixture('clean-draft.md'))
  const content = fixture('clean-draft.md')

  it('reads the header and the request atoms with their lines', () => {
    expect(parsed.header).toMatchObject({ status: 'draft', tier: 'large' })
    expect(parsed.atoms.map((a: { id: string }) => a.id)).toEqual(['R-1', 'R-2', 'R-3', 'R-4'])
    expect(parsed.atoms[0].line).toBe(lineOf(content, '- R-1 Exports stream'))
  })

  it('reads non-goals with the atoms they cite', () => {
    expect(parsed.nonGoals).toEqual([
      { id: 'NG-1', line: lineOf(content, '- NG-1'), cites: ['R-3'] }
    ])
  })

  it('reads slices: lists, backticked globs, the empty dash and gated-by', () => {
    const [s1, s2] = parsed.slices
    expect(s1).toMatchObject({
      id: 'S-1',
      line: lineOf(content, '### S-1'),
      dependsOn: [],
      substrate: 'worktree',
      files: ['src/export/stream.ts', 'tests/export-stream.test.ts'],
      produces: ['export-stream'],
      consumes: ['existing:csv-writer'],
      gatedBy: [],
      acs: ['AC-1']
    })
    expect(s2).toMatchObject({
      id: 'S-2',
      dependsOn: ['S-1'],
      consumes: ['export-stream'],
      gatedBy: ['D-1'],
      acs: ['AC-2']
    })
  })

  it('reads AC rows with the dash as empty and covers as a list', () => {
    expect(parsed.acs).toEqual([
      {
        id: 'AC-1',
        line: lineOf(content, '| AC-1 '),
        statement: 'The export streams rows as they are read.',
        proof: 'test:tests/export-stream.test.ts::streams',
        refines: '',
        covers: ['R-1']
      },
      {
        id: 'AC-2',
        line: lineOf(content, '| AC-2 '),
        statement: 'The export reports progress while running.',
        proof: 'test:tests/export-progress.test.ts::reports',
        refines: 'AC-1',
        covers: ['R-2']
      }
    ])
  })

  it('reads decisions with their status', () => {
    expect(parsed.decisions).toEqual([
      {
        id: 'D-1',
        line: lineOf(content, '| D-1 '),
        status: 'open',
        question: 'Do we cap the export size? (R-4)'
      }
    ])
  })

  it('reads card rows, accepts the ASCII arrow and keeps the last row per slice', () => {
    expect(parsed.cards).toEqual([
      { slice: 'S-1', card: 'stream-card', line: lineOf(content, 'S-1 → stream-card') },
      { slice: 'S-2', card: 'progress-card', line: lineOf(content, 'S-2 -> progress-card') }
    ])
  })

  it('returns empty collections for a file with no header and no sections', () => {
    expect(parseSpec('# Just a title\n')).toEqual({
      header: null,
      atoms: [],
      nonGoals: [],
      slices: [],
      acs: [],
      decisions: [],
      cards: []
    })
  })

  it('parses the real spec of this feature', () => {
    const real = readFileSync(join(ROOT, 'docs/specs/2026-11-harnu-spec/spec.md'), 'utf8')
    const p = parseSpec(real)
    expect(p.atoms.length).toBeGreaterThanOrEqual(33)
    expect(p.slices.map((s: { id: string }) => s.id)).toContain('S-1')
    expect(p.acs.length).toBeGreaterThanOrEqual(41)
    expect(p.decisions.length).toBeGreaterThanOrEqual(14)
  })
})

describe('acHash', () => {
  it('matches the Wave A golden vector', () => {
    expect(
      acHash('The example behaves as described in R-1.', 'test:tests/example.test.ts::behaves')
    ).toBe('#8abc')
  })

  it('collapses runs of whitespace after the join', () => {
    expect(acHash('A   b\n c', 'test:x::y')).toBe(acHash('A b c', 'test:x::y'))
  })
})

describe('checkCapabilityOrder', () => {
  const doc = (slices: string[]): string =>
    [
      '---',
      'status: draft',
      'tier: medium',
      '---',
      '## Slices',
      '',
      ...slices.flatMap((s) => [s, ''])
    ].join('\n')

  const slice = (id: string, dependsOn: string, produces: string, consumes: string): string =>
    [
      `### ${id} · slice`,
      `- depends-on: ${dependsOn}`,
      `- produces: ${produces}`,
      `- consumes: ${consumes}`
    ].join('\n')

  it('accepts a producer in the transitive depends-on closure', () => {
    const content = doc([
      slice('S-1', '—', 'a', '—'),
      slice('S-2', 'S-1', 'b', 'a'),
      slice('S-3', 'S-2', '—', 'a, b')
    ])
    expect(checkCapabilityOrder(parseSpec(content))).toEqual([])
  })

  it('accepts an existing: token with no producer', () => {
    const content = doc([slice('S-1', '—', '—', 'existing:thing')])
    expect(checkCapabilityOrder(parseSpec(content))).toEqual([])
  })

  it('reports missing-producer on the consumes line, naming the capability', () => {
    const content = doc([slice('S-1', '—', '—', 'ghost')])
    const findings = checkCapabilityOrder(parseSpec(content))
    expect(findings).toHaveLength(1)
    expect(findings[0].rule).toBe('missing-producer')
    expect(findings[0].line).toBe(lineOf(content, '- consumes: ghost'))
    expect(findings[0].message).toContain('ghost')
    expect(findings[0].message).toContain('S-1')
  })

  it('fails a slice that consumes only what it produces itself', () => {
    const content = doc([slice('S-1', '—', 'a', 'a')])
    expect(ruleSet(checkCapabilityOrder(parseSpec(content)))).toEqual(['producer-not-before'])
  })

  it('matches tokens exactly and case-sensitively', () => {
    const content = doc([slice('S-1', '—', 'Alpha', '—'), slice('S-2', 'S-1', '—', 'alpha')])
    expect(ruleSet(checkCapabilityOrder(parseSpec(content)))).toEqual(['missing-producer'])
  })

  it('terminates on a depends-on cycle', () => {
    const content = doc([slice('S-1', 'S-2', 'a', '—'), slice('S-2', 'S-1', '—', 'zzz')])
    expect(ruleSet(checkCapabilityOrder(parseSpec(content)))).toEqual(['missing-producer'])
  })
})

describe('checkAtomCoverage', () => {
  it('counts an AC covers cell, an NG bullet and an open-decision question as citations', () => {
    expect(checkAtomCoverage(parseSpec(fixture('clean-draft.md')))).toEqual([])
  })
})

it('capability order rejects the campaign compaction contradiction', () => {
  const content = fixture('campaign-compaction.md')
  const findings = checkSpecFile(content, 'campaign-compaction.md', []) as Finding[]
  expect(findings).toHaveLength(1)
  const [f] = findings
  expect(f.rule).toBe('producer-not-before')
  expect(f.line).toBe(lineOf(content, '- consumes: compaction'))
  expect(f.message).toContain('compaction')
  expect(f.message).toContain('S-1')
  expect(f.message).toContain('S-5')

  // A consumed capability that nothing produces is the other rule.
  const orphan = content.replace('- produces: compaction', '- produces: —')
  const orphanFindings = checkSpecFile(orphan, 'campaign-compaction.md', []) as Finding[]
  expect(ruleSet(orphanFindings)).toEqual(['missing-producer'])
  expect(orphanFindings[0].message).toContain('compaction')
})

it('coverage rejects an uncited atom and a spec with no atoms', () => {
  const defects = fixture('defects-draft.md')
  const uncovered = (checkSpecFile(defects, 'defects-draft.md', []) as Finding[]).filter(
    (f) => f.rule === 'uncovered-atom'
  )
  expect(uncovered).toHaveLength(1)
  expect(uncovered[0].line).toBe(lineOf(defects, '- R-2 The second thing'))
  expect(uncovered[0].message).toContain('R-2')

  const none = fixture('no-atoms.md')
  const noAtoms = checkSpecFile(none, 'no-atoms.md', []) as Finding[]
  expect(ruleSet(noAtoms)).toEqual(['no-atoms'])
  expect(noAtoms[0].line).toBe(lineOf(none, '## Problem'))

  // Every atom cited, one per kind of citation: the spec passes.
  expect(checkSpecFile(fixture('clean-draft.md'), 'clean-draft.md', [])).toEqual([])
})

describe('cli', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GATE_TRACKED_FILES: '', ...env }
    })

  it('lints a draft, collects all findings and sets the exit code', () => {
    const path = join(FIX, 'defects-draft.md')
    const res = run([path])
    expect(res.status).toBe(1)
    const lines = res.stdout.trim().split('\n')
    for (const l of lines) expect(l).toMatch(/^.+:\d+ \[[a-z-]+\] .+$/)
    const rules = lines.map((l) => /\[([a-z-]+)\]/.exec(l)?.[1])
    // The gate's rules run on a draft as if it were approved (they come first) ...
    expect(rules).toContain('duplicate-ac')
    expect(rules).toContain('unknown-slice-ac')
    // ... and the two checks do not stop at the gate's first failure.
    expect(rules).toContain('missing-producer')
    expect(rules).toContain('uncovered-atom')
    expect(rules.indexOf('duplicate-ac')).toBeLessThan(rules.indexOf('missing-producer'))
    expect(rules.indexOf('missing-producer')).toBeLessThan(rules.indexOf('uncovered-atom'))
    expect(lines.every((l) => l.startsWith(`${path}:`))).toBe(true)

    const clean = run([join(FIX, 'clean-draft.md')])
    expect(clean.status).toBe(0)
    expect(clean.stdout).toBe('')

    // Exit 2: no path, an unknown option, an unreadable file.
    expect(run([]).status).toBe(2)
    expect(run([join(FIX, 'clean-draft.md'), '--nope']).status).toBe(2)
    const missing = run([join(FIX, 'does-not-exist.md')])
    expect(missing.status).toBe(2)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('does-not-exist.md')
  })

  it('reports a file with no header block instead of passing it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spec-check-'))
    try {
      const path = join(dir, 'spec.md')
      writeFileSync(path, '# No header\n\n## Problem\n\n- R-1 Something.\n')
      const res = run([path])
      expect(res.status).toBe(1)
      expect(res.stdout).toMatch(/\[bad-header\]/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('checks the real spec of this feature as if approved and finds nothing', () => {
    const res = run([join(ROOT, 'docs/specs/2026-11-harnu-spec/spec.md')], {
      GATE_TRACKED_FILES: 'docs/prds/T601-harnu-spec.md'
    })
    expect(res.stdout).toBe('')
    expect(res.status).toBe(0)
  })
})

it('the ci gate core is the vendored gate core', () => {
  expect(ciGate.checkSpec).toBe(vendoredGate.checkSpec)
  expect(ciGate.specGateVerdict).toBe(vendoredGate.specGateVerdict)
  expect(ciGate.TIERS).toBe(vendoredGate.TIERS)
  expect(ciGate.PATH_FIELDS).toBe(vendoredGate.PATH_FIELDS)
  const reexport = readFileSync(join(ROOT, 'scripts/ci/spec-gate-core.mjs'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('//'))
  expect(reexport).toHaveLength(1)
  expect(reexport[0]).toMatch(
    /^export \* from '.*resources\/skills\/skills\/spec\/scripts\/spec-gate-core\.mjs'$/
  )
})
