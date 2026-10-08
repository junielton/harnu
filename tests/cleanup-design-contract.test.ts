import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// design.md "Type and spacing in the Cleanup files": the Cleanup components use the type tokens, the
// spacing scale and the --gc-* layout variables; the only raw sizes left are the documented exceptions.
const COMPONENTS = join(process.cwd(), 'src/renderer/src/components')
// CleanupSettingsPane keeps the shared Settings-pane anatomy (documented exception).
// CleanupTimeline predates this screen and keeps its own rhythm.
const FILES = readdirSync(COMPONENTS).filter(
  (f) =>
    /^Cleanup.*\.vue$/.test(f) && !['CleanupSettingsPane.vue', 'CleanupTimeline.vue'].includes(f)
)
const read = (f: string): string => readFileSync(join(COMPONENTS, f), 'utf8')
const css = (f: string): string =>
  readFileSync(join(process.cwd(), 'src/renderer/src/styles', f), 'utf8')

// Arbitrary-value utilities that stay, and why (design.md lists each).
const ALLOWED = [
  /^grid-cols-\[[^\]]+\]$/, // list-row column templates
  /^shadow-\[0_0_0_3px_var\(--color-accent-soft\)\]$/, // the busy dot halo
  /^max-w-\[55%\]$/ // a proportion, not a size
]

describe('Cleanup components obey the design contract', () => {
  it('has Cleanup files to check', () => {
    expect(FILES.length).toBeGreaterThan(10)
  })

  for (const f of FILES) {
    it(`${f}: no arbitrary px/em utilities beyond the documented exceptions`, () => {
      const offenders = (
        read(f).match(/[a-z][a-z-]*-\[[^\]\s"']*(?:px|em|rem)[^\]\s"']*\]/g) ?? []
      ).filter((u) => !ALLOWED.some((re) => re.test(u)))
      expect(offenders).toEqual([])
    })
  }

  it('declares the type tokens the components use', () => {
    const main = css('main.css')
    for (const t of ['title', 'subtitle', 'body', 'ui', 'caption', 'eyebrow'])
      expect(main, t).toContain(`--text-${t}:`)
    expect(main).toContain('--radius-xs: 3px')
  })

  it('declares the layout variables, and the treemap constants match them', () => {
    const themes = css('themes.css')
    expect(themes).toContain('--gc-panel-w: 320px')
    expect(themes).toContain('--gc-canvas-h: 372px')
    expect(themes).toContain('--gc-canvas-h-drilled: 520px')
    expect(themes).toContain('--gc-dialog-w: min(720px, 90vw)')
    const tm = read('CleanupTreemap.vue')
    expect(tm).toMatch(/OVERVIEW_H = 372/)
    expect(tm).toMatch(/DRILLED_H = 520/)
  })
})
