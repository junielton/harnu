import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  acHash,
  checkCards,
  parseCard,
  parseSpec
} from '../resources/skills/skills/spec/scripts/spec-check-core.mjs'

/**
 * `spec check --cards` (T601 S-2): card-versus-spec drift. Every board card whose `spec:` names
 * the spec is read; each hashed AC line is compared with the hash recomputed from the spec row
 * (`hash-diverged`), an id the spec does not have is `unknown-ac`, and a slice AC absent from the
 * slice's card is `missing-ac`. An unhashed line is card-only and listed as information. The lint
 * never grades: nothing it prints says whether an AC was met.
 */

const ROOT = resolve(__dirname, '..')
const CLI = join(ROOT, 'resources/skills/skills/spec/scripts/spec-check.mjs')
const FIX = join(ROOT, 'tests/fixtures/spec-check/cards')
const SPEC = join(FIX, 'spec.md')
const ROADMAP = join(FIX, 'board')
const SPEC_REL = 'tests/fixtures/spec-check/cards/spec.md'
const read = (path: string): string => readFileSync(path, 'utf8')

/** Words a grade would use; the drift lint must never print one. */
const VERDICT_RE = /\b(met|unmet|pass(?:es|ed)?|fail(?:s|ed)?|verified|verdict|graded?|done)\b/i

const lineOf = (content: string, needle: string): number => {
  const idx = content.split('\n').findIndex((l) => l.includes(needle))
  if (idx === -1) throw new Error(`fixture has no line containing ${needle}`)
  return idx + 1
}

const run = (args: string[], opts: { cwd?: string } = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, GATE_TRACKED_FILES: '' }
  })

describe('parseCard', () => {
  it('reads the spec header, the slice marker and the AC lines outside fences', () => {
    const content = read(join(ROADMAP, 'stream-card.md'))
    const card = parseCard(content)
    expect(card.spec).toBe(SPEC_REL)
    expect(card.specLine).toBe(lineOf(content, 'spec: tests/'))
    expect(card.slice).toBe('S-1')
    expect(card.sliceLine).toBe(lineOf(content, 'spec-slice: S-1'))
    expect(card.acs).toEqual([
      { id: 'AC-1', hash: '#26ec', line: lineOf(content, '- [ ] AC-1 #26ec') },
      { id: 'AC-2', hash: '#0000', line: lineOf(content, '- [x] AC-2 #0000') },
      { id: 'AC-9', hash: '#1234', line: lineOf(content, '- [ ] AC-9 #1234') },
      { id: 'AC-C', hash: null, line: lineOf(content, '- [ ] AC-C') }
    ])
  })

  it('returns no spec and no slice for a card without them', () => {
    const card = parseCard(read(join(ROADMAP, 'no-spec-card.md')))
    expect(card.spec).toBeNull()
    expect(card.slice).toBeNull()
  })
})

it('reports diverged, invented and missing ACs and never grades', () => {
  const specContent = read(SPEC)
  const parsed = parseSpec(specContent)
  const cardFiles = ['no-spec-card.md', 'other-spec-card.md', 'progress-card.md', 'stream-card.md']
  const cards = cardFiles.map((f) => ({
    path: join(ROADMAP, f),
    slug: f.replace(/\.md$/, ''),
    content: read(join(ROADMAP, f))
  }))
  const { findings, info, matched } = checkCards(parsed, SPEC_REL, cards)
  const stream = read(join(ROADMAP, 'stream-card.md'))
  const progress = read(join(ROADMAP, 'progress-card.md'))

  // Only the two cards whose `spec:` names this spec are read.
  expect(matched).toEqual([join(ROADMAP, 'progress-card.md'), join(ROADMAP, 'stream-card.md')])

  const byRule = (rule: string) => findings.filter((f: { rule: string }) => f.rule === rule)
  // hash-diverged: AC-2's #0000 differs from the hash of the spec row; AC-1 matches and is silent.
  expect(byRule('hash-diverged')).toEqual([
    expect.objectContaining({
      path: join(ROADMAP, 'stream-card.md'),
      line: lineOf(stream, '- [x] AC-2'),
      message: expect.stringContaining(acHash(parsed.acs[1].statement, parsed.acs[1].proof))
    })
  ])
  expect(byRule('hash-diverged')[0].message).toContain('#0000')
  // unknown-ac: AC-9 is absent from the spec; the fenced AC-7 example is not an AC line.
  expect(byRule('unknown-ac')).toEqual([
    expect.objectContaining({
      path: join(ROADMAP, 'stream-card.md'),
      line: lineOf(stream, '- [ ] AC-9'),
      message: expect.stringContaining('AC-9')
    })
  ])
  // missing-ac: S-2 lists AC-3, and its card (found through the Amendments row) has no AC-3 line.
  expect(byRule('missing-ac')).toEqual([
    expect.objectContaining({
      path: join(ROADMAP, 'progress-card.md'),
      line: lineOf(progress, 'spec: tests/'),
      message: expect.stringMatching(/AC-3.*S-2|S-2.*AC-3/)
    })
  ])
  expect(findings).toHaveLength(3)

  // The card-only AC-C lines carry no hash: information, never a finding.
  expect(info).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: join(ROADMAP, 'stream-card.md'),
        line: lineOf(stream, '- [ ] AC-C'),
        message: expect.stringContaining('AC-C')
      }),
      expect.objectContaining({
        path: join(ROADMAP, 'progress-card.md'),
        line: lineOf(progress, '- [ ] AC-C')
      })
    ])
  )

  // The CLI prints the same, per AC line, and nothing it prints is a verdict.
  const res = run([SPEC, '--cards', '--cards-dir', ROADMAP])
  expect(res.status).toBe(1)
  const out = res.stdout.trim().split('\n')
  const rules = out.map((l) => /^.+:\d+ \[([a-z-]+)\] .+$/.exec(l)?.[1]).filter(Boolean)
  expect(rules.sort()).toEqual(['hash-diverged', 'missing-ac', 'unknown-ac'])
  expect(out.filter((l) => /^.+:\d+ info: .*AC-C/.test(l))).toHaveLength(2)
  expect(out.some((l) => l.includes('other-spec-card') || l.includes('no-spec-card'))).toBe(false)
  for (const l of [...out, ...res.stderr.trim().split('\n')]) expect(l).not.toMatch(VERDICT_RE)

  // Without --cards the spec alone is linted and is clean.
  const plain = run([SPEC])
  expect(plain.status).toBe(0)
  expect(plain.stdout).toBe('')

  // Usage errors: --cards-dir without --cards, or without a value; an unreadable cards dir.
  expect(run([SPEC, '--cards-dir', ROADMAP]).status).toBe(2)
  expect(run([SPEC, '--cards', '--cards-dir']).status).toBe(2)
  const missing = run([SPEC, '--cards', '--cards-dir', join(FIX, 'does-not-exist')])
  expect(missing.status).toBe(2)
  expect(missing.stderr).toContain('does-not-exist')
})

it('--cards defaults to the roadmap of the main checkout, seen from a worktree', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'spec-check-cards-')))
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    const main = join(dir, 'main')
    mkdirSync(join(main, 'docs/specs/x'), { recursive: true })
    const spec = read(SPEC)
    writeFileSync(join(main, 'docs/specs/x/spec.md'), spec)
    git(main, 'init', '-q', '-b', 'main')
    git(main, 'add', '.')
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'spec')
    git(main, 'worktree', 'add', '-q', '-b', 'wt', join(dir, 'wt'))
    // The board lives in the main checkout only; the worktree has none.
    mkdirSync(join(main, '.harnu/memory/roadmap'), { recursive: true })
    writeFileSync(
      join(main, '.harnu/memory/roadmap/progress-card.md'),
      read(join(ROADMAP, 'progress-card.md')).replace(SPEC_REL, 'docs/specs/x/spec.md')
    )
    const res = run([join(dir, 'wt/docs/specs/x/spec.md'), '--cards'], { cwd: join(dir, 'wt') })
    expect(res.stdout).toMatch(/progress-card\.md:\d+ \[missing-ac\] /)
    expect(res.status).toBe(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('acHash matches the golden vector and the Phase 2 definition', () => {
  // The golden vector, read from the Formats section of this feature's spec.
  const spec = read(join(ROOT, 'docs/specs/2026-11-harnu-spec/spec.md'))
  const golden =
    /Golden vector: the statement\s+`([^`]+)`\s+with the proof\s+`([^`]+)`\s+hashes to\s+`([0-9a-f]{4})`/.exec(
      spec
    )
  expect(golden).not.toBeNull()
  const [, statement, proof, expected] = golden as RegExpExecArray
  expect(expected).toBe('8abc')
  expect(acHash(statement, proof)).toBe(`#${expected}`)

  // The definition Phase 2 of orchestrate-delivery states: sha256 of `<statement> | <proof>`,
  // whitespace runs collapsed, first four hex characters, computed by the shell pipeline it names.
  const phase2 = read(join(ROOT, 'resources/skills/skills/orchestrate-delivery/SKILL.md'))
  expect(phase2).toContain('`<statement> | <proof>`')
  expect(phase2).toMatch(/runs of whitespace\s+collapsed/)
  expect(phase2).toContain(`(\`printf '%s' "$text" | sha256sum | cut -c1-4\`)`)
  const shell = (text: string): string | null => {
    const res = spawnSync('sh', ['-c', `printf '%s' "$T" | sha256sum | cut -c1-4`], {
      encoding: 'utf8',
      env: { ...process.env, T: text }
    })
    return res.status === 0 && /^[0-9a-f]{4}$/.test(res.stdout.trim()) ? res.stdout.trim() : null
  }
  const vectors: [string, string][] = [
    [statement, proof],
    ['`spec check` keeps `backticks` in the hashed text.', 'test:tests/a.test.ts::keeps'],
    ['An em dash — inside a statement.', 'script:node scripts/x.mjs']
  ]
  for (const [s, p] of vectors) {
    const viaShell = shell(`${s} | ${p}`)
    if (viaShell) expect(acHash(s, p)).toBe(`#${viaShell}`)
  }
  // Whitespace runs collapse after the join; backticks are kept, not stripped.
  expect(acHash('A   b\n\tc', 'test:x::y')).toBe(acHash('A b c', 'test:x::y'))
  expect(acHash('`a`', 'test:x::y')).not.toBe(acHash('a', 'test:x::y'))
  // The real cards of this feature carry the hashes acHash yields for their spec rows.
  const ac7 = parseSpec(spec).acs.find((a: { id: string }) => a.id === 'AC-7')
  expect(acHash(ac7.statement, ac7.proof)).toBe('#8517')
})
