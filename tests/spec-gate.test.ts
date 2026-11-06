import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkSpec, specGateVerdict } from '../scripts/ci/spec-gate-core.mjs'

/**
 * The spec gate (T600, SDD wave A). Runs on every `docs/specs/<dir>/spec.md` whose header
 * says `status: approved` and fails on the leaks measured on Campaign wave 1: duplicate AC
 * ids, a slice citing an AC that does not exist, an AC with no proof, a prd/adr/mockup path
 * that is not a tracked file, a gitignored `.harnu/out` path, and a section outside the
 * tier's whitelist. Draft specs are skipped. The core is pure (text + tracked file list →
 * failures); the CLI feeds it the working tree.
 */

interface FixtureOpts {
  status?: string
  tier?: string
  header?: string[]
  sections?: string[]
  acRows?: string[]
  sliceAcs?: string
}

const AC_TABLE_HEAD = [
  '| id | statement | proof | refines/inherits | covers |',
  '| -- | --------- | ----- | ---------------- | ------ |'
]

function spec(opts: FixtureOpts = {}): string {
  const {
    status = 'approved',
    tier = 'medium',
    header = [],
    sections = [],
    acRows = [
      '| AC-1 | The list paginates 10 per page | test:tests/list.test.ts::paginates | — | R-1 |',
      '| AC-2 | The empty state renders | capture:/list@empty | — | R-1 |'
    ],
    sliceAcs = 'AC-1, AC-2'
  } = opts
  return [
    '---',
    `status: ${status}`,
    `tier: ${tier}`,
    ...header,
    '---',
    '# Acme pagination',
    '',
    '## Problem',
    '',
    'R-1 · The list shows everything at once.',
    '',
    '## Slices',
    '',
    '### S-1 · Paginate the list',
    '',
    '- depends-on: —',
    '- substrate: worktree',
    '- files-may-touch: `src/list.ts`',
    '- produces: pagination',
    '- consumes: —',
    `- acs: ${sliceAcs}`,
    '',
    '## Acceptance criteria',
    '',
    ...AC_TABLE_HEAD,
    ...acRows,
    '',
    ...sections
  ].join('\n')
}

const PATH = 'docs/specs/2026-11-01-acme/spec.md'
const rules = (content: string, tracked: string[] = []): string[] =>
  checkSpec(content, PATH, tracked).map((f: { rule: string }) => f.rule)

describe('checkSpec — the passing baseline', () => {
  it('a well-formed approved medium spec passes with no failures', () => {
    expect(checkSpec(spec(), PATH, [])).toEqual([])
  })

  it('a code fence containing a heading-looking line is not a section', () => {
    const content = spec({ sections: ['```md', '## Not a section', '```'] })
    expect(rules(content)).toEqual([])
  })
})

describe('draft specs are skipped', () => {
  it('a draft spec with every defect still yields no failures', () => {
    const broken = spec({
      status: 'draft',
      acRows: ['| AC-1 | x | | — | R-1 |', '| AC-1 | y | | — | R-1 |'],
      sliceAcs: 'AC-9'
    })
    const verdict = specGateVerdict({ specs: [{ path: PATH, content: broken }], trackedFiles: [] })
    expect(verdict.ok).toBe(true)
    expect(verdict.skipped).toBe(1)
    expect(verdict.checked).toBe(0)
  })

  it('a spec with no header block at all (the existing specs) is skipped', () => {
    const verdict = specGateVerdict({
      specs: [
        { path: PATH, content: '# Old spec\n\n- **Status:** implemented\n\n## 1. Problem\n' }
      ],
      trackedFiles: []
    })
    expect(verdict.ok).toBe(true)
    expect(verdict.skipped).toBe(1)
  })
})

describe('rule: duplicate AC ids', () => {
  it('FAILS when two rows share an id', () => {
    const content = spec({
      acRows: [
        '| AC-1 | one | test:a.test.ts::a | — | R-1 |',
        '| AC-1 | two | test:b.test.ts::b | — | R-1 |'
      ],
      sliceAcs: 'AC-1'
    })
    const found = checkSpec(content, PATH, [])
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['duplicate-ac'])
    expect(found[0].message).toContain('AC-1')
  })

  it('passes when every id is unique', () => {
    expect(rules(spec())).not.toContain('duplicate-ac')
  })
})

describe('rule: a slice cites an AC that does not exist', () => {
  it('FAILS naming the slice and the missing id', () => {
    const found = checkSpec(spec({ sliceAcs: 'AC-1, AC-7' }), PATH, [])
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['unknown-slice-ac'])
    expect(found[0].message).toContain('S-1')
    expect(found[0].message).toContain('AC-7')
  })

  it('passes when every cited id is in the table', () => {
    expect(rules(spec({ sliceAcs: 'AC-2' }))).not.toContain('unknown-slice-ac')
  })

  it('treats an em dash as "no ACs" rather than an unknown id', () => {
    expect(rules(spec({ sliceAcs: '—' }))).toEqual([])
  })
})

describe('rule: an AC with no proof', () => {
  it('FAILS on an empty proof cell', () => {
    const content = spec({ acRows: ['| AC-1 | one | | — | R-1 |'], sliceAcs: 'AC-1' })
    const found = checkSpec(content, PATH, [])
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['missing-proof'])
    expect(found[0].message).toContain('AC-1')
  })

  it('FAILS on a placeholder proof (dash, TBD)', () => {
    const content = spec({
      acRows: ['| AC-1 | one | — | — | R-1 |', '| AC-2 | two | TBD | — | R-1 |']
    })
    expect(rules(content)).toEqual(['missing-proof', 'missing-proof'])
  })

  it('passes when every AC carries a proof', () => {
    expect(rules(spec())).not.toContain('missing-proof')
  })
})

describe('rule: prd / adr / mockup header paths must be tracked files', () => {
  const complex = (header: string[]): string => spec({ tier: 'complex', header })

  it('FAILS when the prd path is not tracked', () => {
    const found = checkSpec(complex(['prd: docs/prds/acme.md']), PATH, [])
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['untracked-path'])
    expect(found[0].message).toContain('docs/prds/acme.md')
  })

  it('passes when prd and adr are tracked files and the mockup is a tracked directory', () => {
    const tracked = ['docs/prds/acme.md', 'docs/adr/0001-acme.md', 'docs/design/acme/index.html']
    const content = complex([
      'prd: docs/prds/acme.md',
      'adr: docs/adr/0001-acme.md',
      'mockup: docs/design/acme/'
    ])
    expect(rules(content, tracked)).toEqual([])
  })

  it('FAILS when a mockup directory has no tracked file under it', () => {
    const found = rules(complex(['mockup: docs/design/acme/']), ['docs/design/other/a.html'])
    expect(found).toEqual(['untracked-path'])
  })
})

describe('rule: no .harnu/out path anywhere', () => {
  it('FAILS on a header path under .harnu/out', () => {
    const found = rules(spec({ tier: 'complex', header: ['mockup: .harnu/out/mockups/acme/'] }))
    expect(found).toContain('harnu-out-path')
  })

  it('FAILS on a mention in the body, with its line number', () => {
    const content = spec({ sections: ['See `.harnu/out/notes.md` for the research.'] })
    const found = checkSpec(content, PATH, [])
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['harnu-out-path'])
    expect(found[0].line).toBeGreaterThan(1)
  })

  it('passes when the spec points at committed paths only', () => {
    expect(rules(spec({ sections: ['See `docs/research/notes.md`.'] }))).toEqual([])
  })
})

describe('rule: sections are limited to the tier whitelist', () => {
  const goals = '## Goals\n\n- G1 Ship it.\n'
  const decisions = '## Open decisions\n\n| id | question |\n| -- | -------- |\n| D-1 | Which? |\n'

  it('FAILS a medium spec that carries Goals', () => {
    const found = checkSpec(spec({ sections: [goals] }), PATH, [])
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['section-outside-tier'])
    expect(found[0].message).toContain('Goals')
    expect(found[0].message).toContain('medium')
  })

  it('FAILS a medium spec that carries Open decisions', () => {
    expect(rules(spec({ sections: [decisions] }))).toEqual(['section-outside-tier'])
  })

  it('FAILS a section that is on no tier whitelist', () => {
    expect(rules(spec({ tier: 'complex', sections: ['## Rollout plan\n\ntext\n'] }))).toEqual([
      'section-outside-tier'
    ])
  })

  it('passes Goals and Open decisions on a large spec', () => {
    expect(rules(spec({ tier: 'large', sections: [goals, decisions] }))).toEqual([])
  })

  it('FAILS prd/adr/mockup header fields on a non-complex spec', () => {
    const found = checkSpec(spec({ tier: 'large', header: ['prd: docs/prds/acme.md'] }), PATH, [
      'docs/prds/acme.md'
    ])
    expect(found.map((f: { rule: string }) => f.rule)).toEqual(['section-outside-tier'])
    expect(found[0].message).toContain('prd')
  })

  it('accepts numbered headings and the append-only Amendments section on every tier', () => {
    const content = spec({
      sections: ['## 6. Amendments · Deviations\n\n| date | what |\n| -- | -- |\n']
    })
    expect(rules(content)).toEqual([])
  })

  it('FAILS an approved spec whose tier is missing or unknown', () => {
    expect(rules(spec({ tier: 'huge' }))).toEqual(['bad-header'])
  })
})

describe('specGateVerdict', () => {
  it('is ok with zero specs', () => {
    expect(specGateVerdict({ specs: [], trackedFiles: [] }).ok).toBe(true)
  })

  it('reports each failure with its spec path and a readable summary', () => {
    const verdict = specGateVerdict({
      specs: [{ path: PATH, content: spec({ sliceAcs: 'AC-9' }) }],
      trackedFiles: []
    })
    expect(verdict.ok).toBe(false)
    expect(verdict.failures[0].path).toBe(PATH)
    expect(verdict.reason).toContain(PATH)
    expect(verdict.reason).toContain('AC-9')
  })
})

describe('the real template', () => {
  it('docs/specs/TEMPLATE.md passes the gate once marked approved (the template is expressible)', () => {
    const template = readFileSync(resolve(__dirname, '../docs/specs/TEMPLATE.md'), 'utf8')
    const approved = template.replace(/^status:.*$/m, 'status: approved')
    const tracked = [
      'docs/prds/example.md',
      'docs/adr/0000-example.md',
      'docs/design/example/index.html'
    ]
    expect(checkSpec(approved, 'docs/specs/TEMPLATE.md', tracked)).toEqual([])
  })
})

describe('CLI (scripts/ci/spec-gate.mjs)', () => {
  const cli = resolve(__dirname, '../scripts/ci/spec-gate.mjs')

  function run(content: string): { code: number; out: string } {
    const dir = mkdtempSync(join(tmpdir(), 'spec-gate-'))
    try {
      mkdirSync(join(dir, 'docs/specs/2026-11-01-acme'), { recursive: true })
      writeFileSync(join(dir, PATH), content)
      try {
        const out = execFileSync('node', [cli], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, GATE_TRACKED_FILES: '' }
        })
        return { code: 0, out }
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string }
        return { code: err.status, out: `${err.stdout}${err.stderr}` }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('exits 0 on a clean approved spec', () => {
    const r = run(spec())
    expect(r.code).toBe(0)
    expect(r.out).toContain('spec gate')
  })

  it('exits 1 and names the rule on a broken approved spec', () => {
    const r = run(spec({ sliceAcs: 'AC-9' }))
    expect(r.code).toBe(1)
    expect(r.out).toContain('unknown-slice-ac')
  })
})

describe('wiring (AC-2b)', () => {
  const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

  it('CI and the local pipeline both run the spec gate next to the other contract gates', () => {
    expect(read('.github/workflows/ci.yml')).toContain('node scripts/ci/spec-gate.mjs')
    const pipeline = read('scripts/ci/local-pipeline.sh')
    expect(pipeline).toContain('run_step spec-gate')
    expect(pipeline).toContain('node scripts/ci/spec-gate.mjs')
    expect(pipeline).toContain('spec-gate')
  })
})
