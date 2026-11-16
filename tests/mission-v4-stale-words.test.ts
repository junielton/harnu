/**
 * Missions v4 · S-43 · AC-97 — the words the new model retired stay out of the live surfaces.
 *
 * Scanned (the live surfaces): `resources/skills/**`, `docs/harnu-features.md`, `docs/user/**`,
 * `src/renderer/src/i18n/**`. History is exempt and is exactly `docs/specs`, `docs/adr`,
 * `docs/prds`, `docs/lessons` and `CHANGELOG.md`: they record what was true when written.
 * The word "popover" alone is not retired; only the phrases below are.
 *
 * The i18n folder holds a Portuguese locale, so each retired phrase is also checked in the
 * Portuguese wording a translator would have used for it.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '..')

/** What the rule scans, relative to the repo root: a file or a directory (walked). */
const LIVE_SURFACES = [
  'resources/skills',
  'docs/harnu-features.md',
  'docs/user',
  'src/renderer/src/i18n'
] as const

const TEXT_EXT = new Set(['.md', '.mjs', '.json', '.ts', '.txt', '.yaml', '.yml'])

/** The retired phrases, matched case-insensitively with any run of whitespace between words. */
const RETIRED_EN = [
  'campaign map',
  'merge batch',
  'Mission popover',
  'Campaign popover',
  'Pause steward',
  'steward tick'
] as const

/** Portuguese forms of the same phrases, checked in the pt-BR locale (and everywhere else). */
const RETIRED_PT = [
  'mapa d[ae] campanha',
  'lote de merge',
  'merge em lote',
  'popover d[ae] miss[ãa]o',
  'popover d[ae] campanha',
  'pausar (?:o )?steward',
  'tick d[oe] steward'
] as const

export interface Hit {
  file: string
  line: number
  phrase: string
}

function phrasePattern(phrase: string, isRegex: boolean): RegExp {
  const source = isRegex ? phrase : phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(source.replace(/ /g, '\\s+'), 'i')
}

const PATTERNS: { phrase: string; re: RegExp }[] = [
  ...RETIRED_EN.map((p) => ({ phrase: p, re: phrasePattern(p, false) })),
  ...RETIRED_PT.map((p) => ({ phrase: p, re: phrasePattern(p, true) }))
]

/** Every retired phrase in `text`, with its 1-based line. */
export function retiredPhrases(file: string, text: string): Hit[] {
  const out: Hit[] = []
  text.split('\n').forEach((lineText, i) => {
    for (const { phrase, re } of PATTERNS) {
      if (re.test(lineText)) out.push({ file, line: i + 1, phrase })
    }
  })
  return out
}

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  const st = statSync(abs)
  if (st.isFile()) return TEXT_EXT.has(path.extname(rel)) ? [rel] : []
  return readdirSync(abs).flatMap((name) => walk(path.posix.join(rel, name)))
}

describe('Missions v4 · retired words (AC-97)', () => {
  it('the scan reads real files and sees a planted phrase', () => {
    const files = LIVE_SURFACES.flatMap(walk)
    expect(files.length).toBeGreaterThan(20)
    expect(files).toContain('docs/harnu-features.md')
    expect(retiredPhrases('x.md', 'Open the Mission  popover.\nok line')).toEqual([
      { file: 'x.md', line: 1, phrase: 'Mission popover' }
    ])
    expect(retiredPhrases('x.md', 'Use the popover on the pill.')).toEqual([])
    expect(retiredPhrases('x.json', '"Popover da missão"')).toHaveLength(1)
  })

  it('retired phrases are gone from the live surfaces', () => {
    const hits = LIVE_SURFACES.flatMap(walk).flatMap((file) =>
      retiredPhrases(file, readFileSync(path.join(ROOT, file), 'utf8'))
    )
    expect(
      hits.map((h) => `${h.file}:${h.line} "${h.phrase}"`),
      'retired phrases found in live surfaces'
    ).toEqual([])
  })
})
