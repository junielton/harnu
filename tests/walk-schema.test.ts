import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateWalkScript, type WalkProbe } from '../src/shared/walk-schema'
import { createWalkProbe } from '../src/main/walk/walk-links'

/** A complete, valid `check` walk (neutral sample data). */
function script(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Search box on the notes list',
    purpose: 'check',
    source: { kind: 'feature', text: 'A search box that filters the notes list as you type.' },
    checks: [check()],
    ...over
  }
}

function check(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    title: 'Typing narrows the list',
    why: 'The box filters notes as you type; it is the whole feature.',
    where: { text: 'example-web, Notes page' },
    do: [{ text: 'Open the Notes page and type `standup`.', see: 'Only two notes stay.' }],
    passes: 'The list shows exactly 2 rows.',
    fails: 'More than 2 rows or an empty list.',
    check: { how: 'curl the preview and count the rows' },
    ...over
  }
}

function rules(input: unknown, probe: WalkProbe): string[] {
  const r = validateWalkScript(input, probe)
  return r.ok ? [] : r.violations.map((v) => `${v.path} ${v.rule}`)
}

let dir: string
let probe: WalkProbe

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'walk-schema-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'filter.ts'), 'export {}\n')
  mkdirSync(join(dir, 'docs'), { recursive: true })
  writeFileSync(join(dir, 'docs', 'ok.png'), Buffer.alloc(1024))
  writeFileSync(join(dir, 'docs', 'big.png'), Buffer.alloc(2 * 1024 * 1024 + 1))
  probe = createWalkProbe({
    folder: dir,
    knownFolders: [dir, '/work/other'],
    cardSlugs: () => ['t100-card'],
    mission: () => null,
    imageRoots: []
  })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('walk script schema', () => {
  it('accepts a complete script', () => {
    const r = validateWalkScript(script(), probe)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.script.purpose).toBe('check')
  })

  it('refuses an incomplete check, one violation per rule', () => {
    const bare = check()
    delete bare.where
    delete bare.passes
    delete bare.fails
    delete bare.check
    bare.do = [{ text: 'Open it.' }]
    const r = validateWalkScript(script({ checks: [bare] }), probe)
    expect(r.ok).toBe(false)
    const got = rules(script({ checks: [bare] }), probe)
    expect(got).toEqual(
      expect.arrayContaining([
        '$.checks[0].where MISSING',
        '$.checks[0].do[0].see MISSING',
        '$.checks[0].passes MISSING',
        '$.checks[0].fails MISSING',
        '$.checks[0].check NO_CHECK_OR_NOTHING_FROM_HERE'
      ])
    )
    // one violation per rule: the same rule at the same path is never listed twice
    expect(new Set(got).size).toBe(got.length)

    // `nothingFromHere` satisfies the "agent check" rule; both together do not
    expect(
      rules(
        script({ checks: [check({ check: undefined, nothingFromHere: 'Needs eyes.' })] }),
        probe
      )
    ).toEqual([])
    expect(rules(script({ checks: [check({ nothingFromHere: 'Needs eyes.' })] }), probe)).toContain(
      '$.checks[0].check BOTH_CHECK_AND_NOTHING_FROM_HERE'
    )

    // a `learn` walk: `fails` is optional and `teach` is accepted
    const learn = check({
      teach: { what: 'A debounced filter.', why: 'The list is small.' },
      more: 'Why this matters.'
    })
    delete learn.fails
    expect(rules(script({ purpose: 'learn', checks: [learn] }), probe)).toEqual([])
    // the same check in a `check` walk misses `fails`
    expect(rules(script({ purpose: 'check', checks: [learn] }), probe)).toContain(
      '$.checks[0].fails MISSING'
    )
  })

  it('enforces the caps, counts and cross-check rules', () => {
    const long = 'x'.repeat(300)
    const got = rules(
      script({
        checks: [
          check({
            title: 'T'.repeat(51),
            passes: long,
            do: Array.from({ length: 9 }, () => ({ text: 'a', see: 'b' })),
            blocks: ['c9']
          }),
          check({ id: 'c1' })
        ]
      }),
      probe
    )
    expect(got).toEqual(
      expect.arrayContaining([
        '$.checks[0].title TOO_LONG',
        '$.checks[0].passes TOO_LONG',
        '$.checks[0].do TOO_MANY',
        '$.checks[0].blocks UNKNOWN_CHECK',
        '$.checks[1].id DUPLICATE_ID'
      ])
    )
    // a blocked check must come later
    const back = rules(
      script({ checks: [check({ id: 'c1' }), check({ id: 'c2', blocks: ['c1'] })] }),
      probe
    )
    expect(back).toContain('$.checks[1].blocks NOT_LATER')
    // a refused script is refused whole: a non-object is one violation
    expect(rules('nope', probe)).toEqual(['$ NOT_AN_OBJECT'])
  })

  it('refuses an unopenable link, an emoji, a secret and a placeholder', () => {
    const links = [
      { label: 'ok file', kind: 'file', target: 'src/filter.ts', line: 3 },
      { label: 'ghost', kind: 'file', target: 'src/nope.ts' },
      { label: 'escape', kind: 'file', target: '../outside.ts' },
      { label: 'pr', kind: 'pr', target: '101' },
      { label: 'bad pr', kind: 'pr', target: 'abc' },
      {
        label: 'url',
        kind: 'url',
        target: 'https://example.org/x',
        checked: { status: 'ok', at: '2026-11-17T21:10:00Z' }
      },
      { label: 'url no checked', kind: 'url', target: 'https://example.org/y' },
      {
        label: 'js',
        kind: 'url',
        target: 'javascript:alert(1)',
        checked: { status: 'ok', at: '2026-11-17T21:10:00Z' }
      },
      { label: 'folder', kind: 'folder', target: '/work/other' },
      { label: 'unknown folder', kind: 'folder', target: '/work/unknown' }
    ]
    const got = rules(script({ checks: [check({ where: { text: 'here', links } })] }), probe)
    const at = (i: number): string => `$.checks[0].where.links[${i}]`
    expect(got).toEqual(
      expect.arrayContaining([
        `${at(1)}.target FILE_NOT_FOUND`,
        `${at(2)}.target FILE_NOT_FOUND`,
        `${at(4)}.target PR_NOT_A_NUMBER`,
        `${at(6)}.checked MISSING`,
        `${at(7)}.target URL_NOT_HTTP`,
        `${at(9)}.target FOLDER_UNKNOWN`
      ])
    )
    for (const i of [0, 3, 5, 8]) expect(got.some((g) => g.startsWith(at(i)))).toBe(false)

    // a click path needs `approximate`
    expect(
      rules(script({ checks: [check({ where: { text: 'here', path: 'Menu > Notes' } })] }), probe)
    ).toContain('$.checks[0].where.approximate MISSING')
    expect(
      rules(
        script({
          checks: [check({ where: { text: 'here', path: 'Menu > Notes', approximate: false } })]
        }),
        probe
      )
    ).toEqual([])

    // images: inside the jail and at most 2 MB
    const img = (src: string): Record<string, unknown> => ({ src, alt: 'a', kind: 'expected' })
    const imgs = rules(
      script({ checks: [check({ images: [img('docs/ok.png'), img('docs/big.png')] })] }),
      probe
    )
    expect(imgs).toEqual(['$.checks[0].images[1].src IMAGE_TOO_BIG'])
    expect(rules(script({ checks: [check({ images: [img('/etc/passwd.png')] })] }), probe)).toEqual(
      ['$.checks[0].images[0].src IMAGE_OUTSIDE_JAIL']
    )
    expect(
      rules(script({ checks: [check({ images: [img('docs/missing.png')] })] }), probe)
    ).toEqual(['$.checks[0].images[0].src IMAGE_MISSING'])

    // an image reached through a symlink that leaves the jail is outside it
    const outside = mkdtempSync(join(tmpdir(), 'walk-outside-'))
    writeFileSync(join(outside, 'x.png'), Buffer.alloc(10))
    symlinkSync(outside, join(dir, 'docs', 'link'))
    expect(rules(script({ checks: [check({ images: [img('docs/link/x.png')] })] }), probe)).toEqual(
      ['$.checks[0].images[0].src IMAGE_OUTSIDE_JAIL']
    )
    rmSync(outside, { recursive: true, force: true })

    // an emoji, a secret-looking value and a <placeholder> in a command
    const text = rules(
      script({
        title: 'Search box 🚀',
        checks: [
          check({
            passes: 'It works ✅',
            do: [
              {
                text: 'Run it.',
                see: 'Output.',
                block: { text: 'curl -H "Authorization: Bearer abcdef1234567890abcdef" localhost' }
              },
              { text: 'Run it.', see: 'Output.', block: { text: 'git checkout <branch-name>' } }
            ],
            check: { how: 'export API_TOKEN=abcdef1234567890abcdef then run' }
          })
        ]
      }),
      probe
    )
    expect(text).toEqual(
      expect.arrayContaining([
        '$.title EMOJI',
        '$.checks[0].passes EMOJI',
        '$.checks[0].do[0].block.text SECRET',
        '$.checks[0].do[1].block.text PLACEHOLDER_IN_COMMAND',
        '$.checks[0].check.how SECRET'
      ])
    )
  })

  it('validates pre-closed rows and the left-out list', () => {
    const closed = check({ id: 'c2', status: 'verified', evidence: 'Seen in the PR.' })
    expect(rules(script({ checks: [check(), closed] }), probe)).toEqual([])
    expect(
      rules(script({ checks: [check({ id: 'c2', status: 'caveat', evidence: 'Seen.' })] }), probe)
    ).toContain('$.checks[0].openPr MISSING')
    expect(rules(script({ checks: [check({ id: 'c2', status: 'verified' })] }), probe)).toContain(
      '$.checks[0].evidence MISSING'
    )
    expect(
      rules(script({ leftOut: [{ text: 'Rename the file', owner: 'someone' }] }), probe)
    ).toContain('$.leftOut[0].owner BAD_VALUE')
  })
})
