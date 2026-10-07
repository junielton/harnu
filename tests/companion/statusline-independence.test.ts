import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN = resolve(import.meta.dirname, '..', '..', 'src', 'main')

/** Every module specifier a source file imports or re-exports from, comments stripped. */
function specifiers(file: string): string[] {
  const text = readFileSync(join(MAIN, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const out: string[] = []
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) out.push(m[1]!)
  return out
}

describe('the statusLine side is independent of companion state (lesson framework/005)', () => {
  it('no companion import', () => {
    for (const f of ['statusline.ts', 'statusline-install.ts']) {
      const bad = specifiers(f).filter((s) => /companion/.test(s))
      expect(bad, `${f} imports ${bad.join(', ')}`).toEqual([])
    }
  })

  it('the neutral store and compose core import nothing under companion either', () => {
    for (const f of ['telemetry-store.ts', 'telemetry-compose-core.ts', 'statusline-parse.ts']) {
      const bad = specifiers(f).filter((s) => /companion/.test(s))
      expect(bad, `${f} imports ${bad.join(', ')}`).toEqual([])
    }
  })

  it('the companion adapter never imports the statusLine install or settings modules', () => {
    for (const f of [
      'companion/ingest/telemetry-adapter.ts',
      'companion/ingest/usage-map-core.ts'
    ]) {
      const bad = specifiers(f).filter((s) =>
        /statusline-install|claude-settings|\/statusline$/.test(s)
      )
      expect(bad, `${f} imports ${bad.join(', ')}`).toEqual([])
    }
  })
})
