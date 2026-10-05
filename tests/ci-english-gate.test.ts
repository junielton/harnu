import { describe, it, expect } from 'vitest'
import { findViolations, isAllowedPath } from '../scripts/ci/english-gate-core.mjs'

type Hit = { path: string; line: number; text: string }
const scan = (path: string, text: string): Hit[] => findViolations([{ path, text }])

describe('english gate core', () => {
  it('flags a Portuguese comment in source', () => {
    const hits = scan('src/main/x.ts', '// ok\n// isso não funciona aqui\n')
    expect(hits).toEqual([{ path: 'src/main/x.ts', line: 2, text: '// isso não funciona aqui' }])
  })

  it('flags the -ção suffix and the ã vowel on their own', () => {
    expect(scan('docs/a.md', 'a configuração')).toHaveLength(1)
    expect(scan('docs/a.md', 'irmã')).toHaveLength(1)
  })

  it('leaves English and English loanwords alone', () => {
    expect(scan('src/a.ts', 'const pro = plan.tier // café, naïve, résumé, bézier')).toEqual([])
  })

  it('skips the pt-BR locale but not en.json', () => {
    expect(isAllowedPath('src/renderer/src/i18n/pt-BR.json')).toBe(true)
    expect(isAllowedPath('src/renderer/src/i18n/en.json')).toBe(false)
    expect(scan('src/renderer/src/i18n/en.json', '"a": "não"')).toHaveLength(1)
  })

  it('ignores files it does not scan', () => {
    expect(scan('resources/icon.png', 'não')).toEqual([])
  })
})
