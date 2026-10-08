import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const load = (locale: string): { cleanup: { gc: Record<string, unknown> } } =>
  JSON.parse(readFileSync(join(process.cwd(), `src/renderer/src/i18n/${locale}.json`), 'utf8'))

function strings(o: unknown, path: string[] = []): Array<[string, string]> {
  if (typeof o === 'string') return [[path.join('.'), o]]
  if (o && typeof o === 'object')
    return Object.entries(o).flatMap(([k, v]) => strings(v, [...path, k]))
  return []
}

describe('Cleanup copy — the review bucket has one name per locale (D2)', () => {
  it('pt-BR calls the review bucket "Precisa de revisão", never "Precisa de você"', () => {
    const pt = load('pt-BR').cleanup.gc
    expect(pt.bucket).toMatchObject({ review: 'Precisa de revisão' })
    const offenders = strings(pt).filter(([, v]) => /precis(a|am) de você/i.test(v))
    expect(offenders).toEqual([])
  })

  it('en keeps "Needs review" in the same keys', () => {
    const en = load('en').cleanup.gc
    expect(en.bucket).toMatchObject({ review: 'Needs review' })
  })
})
