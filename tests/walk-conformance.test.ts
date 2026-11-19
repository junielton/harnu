/**
 * Guided walks · S-7 — the conformance proof closes (AC-38; spec "S-7", "Acceptance criteria", "The conformance
 * matrix").
 *
 * Every row of the spec's conformance matrix and every acceptance criterion cites a proof: a unit test
 * (`file.test.ts::its leading words`), a smoke case (`W-n`), a script, or a capture. This test reads the spec and
 * checks each citation points at something that exists: the test file, an `it` whose name starts with the cited
 * words (a cited name may be shortened to its leading words and is matched by prefix), the smoke case in the
 * script, the script file, the capture in the smoke script. A citation of a thing that was never written is
 * how a proof quietly rots; this fails it by name.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const SPEC = 'docs/specs/2026-11-17-guided-test-walk/spec.md'
const SMOKE_DIR = 'scripts/verify/guided-test-walk'

const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const cells = (line: string): string[] =>
  line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim())

/** Every `it(` / `test(` title of a test file, as written (escapes resolved for the quote it was written in). */
function titlesOf(src: string): string[] {
  const out: string[] = []
  const re = /\b(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  for (let m = re.exec(src); m; m = re.exec(src))
    out.push(m[2].replace(/\\(['"`\\])/g, '$1').replace(/\s+/g, ' '))
  return out
}

/** The smoke cases the script really has (`id: 'W-n'`, in every case file). */
function smokeCases(): Set<string> {
  const ids = new Set<string>()
  for (const f of readdirSync(join(ROOT, SMOKE_DIR)))
    if (/^cases-.*\.mjs$/.test(f))
      for (const m of read(`${SMOKE_DIR}/${f}`).matchAll(/\bid:\s*'(W-\d+)'/g)) ids.add(m[1])
  return ids
}

/** Every file of the smoke script, joined: where a capture's name must be written. */
function smokeSource(): string {
  const parts = [read('scripts/verify/guided-test-walk.mjs')]
  for (const f of readdirSync(join(ROOT, SMOKE_DIR)))
    if (f.endsWith('.mjs')) parts.push(read(`${SMOKE_DIR}/${f}`))
  return parts.join('\n')
}

interface Citation {
  /** Where it is cited: the matrix row or the acceptance criterion. */
  from: string
  kind: 'test' | 'case' | 'script' | 'capture'
  /** The file (test), the case id, the script path or the capture name. */
  target: string
  /** A test's cited name (the leading words of an `it`). */
  name?: string
}

/** Read every citation out of the matrix's proof column and the acceptance criteria's proof column. */
function citations(spec: string): Citation[] {
  const out: Citation[] = []
  for (const line of spec.split('\n')) {
    if (!line.startsWith('|')) continue
    const c = cells(line)
    const id = c[0] ?? ''
    if (/^M-(A-)?\d+$/.test(id) && c.length >= 4) {
      for (const part of c[c.length - 1].split(';').map((p) => p.trim())) {
        if (/^W-\d+$/.test(part)) out.push({ from: id, kind: 'case', target: part })
        else {
          const m = /^(walk-[\w-]+\.test\.ts|step-by-step-panel-mode\.test\.ts)::(.+)$/.exec(part)
          if (m) out.push({ from: id, kind: 'test', target: `tests/${m[1]}`, name: m[2].trim() })
        }
      }
    } else if (/^AC-\d+$/.test(id) && c.length >= 5) {
      const proof = c[2]
      const test = /^test:(tests\/[\w./-]+\.test\.ts)::(.+)$/.exec(proof)
      if (test) out.push({ from: id, kind: 'test', target: test[1], name: test[2].trim() })
      const capture = /^capture:\/@([\w-]+)$/.exec(proof)
      if (capture) out.push({ from: id, kind: 'capture', target: capture[1] })
      if (proof.startsWith('script:')) {
        for (const cmd of proof
          .slice('script:'.length)
          .split('&&')
          .map((p) => p.trim())) {
          const file = /^node (scripts\/[\w./-]+\.mjs)/.exec(cmd)
          if (file) out.push({ from: id, kind: 'script', target: file[1] })
          const w = /--case (W-\d+)/.exec(cmd)
          if (w) out.push({ from: id, kind: 'case', target: w[1] })
        }
      }
    }
  }
  return out
}

describe('AC-38 — every cited proof exists', () => {
  const spec = read(SPEC)
  const cited = citations(spec)

  it('reads the matrix and the acceptance criteria (the test would pass on an empty read otherwise)', () => {
    expect(cited.filter((c) => c.from.startsWith('M-')).length).toBeGreaterThan(60)
    expect(cited.filter((c) => c.from.startsWith('AC-')).length).toBeGreaterThan(40)
    expect(new Set(cited.map((c) => c.kind))).toEqual(
      new Set(['test', 'case', 'script', 'capture'])
    )
  })

  it('every cited proof exists', () => {
    const cases = smokeCases()
    const smoke = smokeSource()
    const missing: string[] = []
    const titles = new Map<string, string[]>()
    for (const c of cited) {
      if (c.kind === 'test') {
        if (!existsSync(join(ROOT, c.target))) {
          missing.push(`${c.from}: the test file ${c.target} does not exist`)
          continue
        }
        if (!titles.has(c.target)) titles.set(c.target, titlesOf(read(c.target)))
        const want = c.name ?? ''
        // a cited name may be shortened to its leading words: matched by prefix
        if (!titles.get(c.target)!.some((t) => t.startsWith(want)))
          missing.push(`${c.from}: ${c.target} has no it() named "${want}…"`)
      } else if (c.kind === 'case') {
        if (!cases.has(c.target))
          missing.push(`${c.from}: the smoke script has no case ${c.target}`)
      } else if (c.kind === 'script') {
        if (!existsSync(join(ROOT, c.target)))
          missing.push(`${c.from}: the script ${c.target} does not exist`)
      } else if (!smoke.includes(c.target)) {
        missing.push(`${c.from}: no smoke case writes the capture "${c.target}"`)
      }
    }
    expect(missing, `\n${missing.join('\n')}\n`).toEqual([])
  })

  it('a citation the spec makes of S-7 itself is among the ones checked', () => {
    // the slice this test closes: its own tests, its smoke case and its capture are cited and found
    const own = cited.filter((c) => ['AC-35', 'AC-36', 'AC-37', 'AC-38', 'AC-42'].includes(c.from))
    expect(own.map((c) => `${c.from}:${c.kind}:${c.target}`).sort()).toEqual(
      [
        'AC-35:test:tests/walk-request.test.ts',
        'AC-36:capture:mission-dropdown-test-it',
        'AC-37:test:tests/walk-request.test.ts',
        'AC-38:test:tests/walk-conformance.test.ts',
        'AC-42:case:W-21',
        'AC-42:script:scripts/verify/guided-test-walk.mjs'
      ].sort()
    )
  })
})
