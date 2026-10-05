/**
 * T389 P4W1 — AC-P4W1-6. The Mods pane describes what a mod CAN do; it never
 * grades one (R16, P4W1-S1). Every `modsAudit.*` string, in both locales, is
 * scanned for the words that read as a verdict.
 */
import { describe, it, expect } from 'vitest'
import en from '../src/renderer/src/i18n/en.json'
import ptBR from '../src/renderer/src/i18n/pt-BR.json'
import { CAPABILITY_ORDER } from '../src/main/mods-audit-core'

type Tree = { [k: string]: string | Tree }

function leaves(tree: Tree, prefix = ''): { key: string; text: string }[] {
  return Object.entries(tree).flatMap(([k, v]) =>
    typeof v === 'string' ? [{ key: `${prefix}${k}`, text: v }] : leaves(v, `${prefix}${k}.`)
  )
}

const VERDICT_WORDS = [
  // en
  'safe',
  'safely',
  'safety',
  'verified',
  'trusted',
  'secure',
  'malicious',
  'approved',
  // pt-BR
  'seguro',
  'segura',
  'seguros',
  'seguras',
  'verificado',
  'verificada',
  'verificados',
  'confiável',
  'confiáveis',
  'malicioso',
  'maliciosa',
  'aprovado',
  'aprovada',
  'aprovados'
]
const VERDICT = new RegExp(`(?<![\\p{L}])(${VERDICT_WORDS.join('|')})(?![\\p{L}])`, 'iu')

describe('modsAudit copy', () => {
  for (const [locale, messages] of [
    ['en', en],
    ['pt-BR', ptBR]
  ] as const) {
    it(`chips never read as a verdict (${locale})`, () => {
      const all = leaves((messages as unknown as { modsAudit: Tree }).modsAudit, 'modsAudit.')
      expect(all.length).toBeGreaterThan(40)
      for (const { key, text } of all) {
        expect(text, key).not.toMatch(VERDICT)
      }
    })
  }

  it('chips never read as a verdict', () => {
    // the scan itself catches what it should
    expect('This mod is safe').toMatch(VERDICT)
    expect('Este mod é seguro').toMatch(VERDICT)
    expect('Harnu cannot tell whether this one is approved to load.').toMatch(VERDICT)
    expect('Harnu cannot tell whether this one is allowed to load.').not.toMatch(VERDICT)
  })

  it('has one chip string per capability, in both locales', () => {
    for (const messages of [en, ptBR]) {
      const cap = (messages as unknown as { modsAudit: { cap: Record<string, string> } }).modsAudit
        .cap
      expect(Object.keys(cap).sort()).toEqual([...CAPABILITY_ORDER].sort())
    }
  })

  it('words the capability chips as facts', () => {
    const cap = (en as unknown as { modsAudit: { cap: Record<string, string> } }).modsAudit.cap
    for (const id of CAPABILITY_ORDER) {
      expect(cap[id], id).toMatch(/^(can |draws |has )/)
    }
  })
})
