import { describe, it, expect } from 'vitest'
import {
  parseExtensionManifest,
  parseThemeContributions,
  parseBoardTemplateContributions,
  parseModeContributions
} from '../src/main/extensions/extension-manifest-core'

/**
 * T137 — Extension SDK Phase 1 shared loader, pure core.
 *
 * Invariants pinned (ADR-0002 §2.2):
 *  - a structurally invalid manifest (not an object, no id/label, id
 *    mismatching its folder) is REJECTED with a reason;
 *  - each `contributes` key — and each entry within it — validates
 *    INDEPENDENTLY: one broken theme never disables a working sibling theme
 *    or the pack's board templates;
 *  - a theme missing ANY of the 36 tokens is dropped, never silently
 *    inherits a default (stricter than the in-repo `themes.css` contract).
 */

const validTokens = {
  bg: '#111111',
  sidebar: '#121212',
  surface: '#131313',
  surface2: '#141414',
  border: '#151515',
  border2: '#161616',
  text: '#eeeeee',
  text2: '#dddddd',
  text3: '#cccccc',
  text4: '#bbbbbb',
  textDisabled: '#aaaaaa',
  accent: '#7aa2f7',
  accentSoft: 'rgba(1,2,3,0.1)',
  accentLine: 'rgba(1,2,3,0.3)',
  accentInk: '#000000',
  green: '#00ff00',
  greenSoft: 'rgba(0,255,0,0.1)',
  red: '#ff0000',
  redSoft: 'rgba(255,0,0,0.1)',
  warning: '#ffaa00',
  ansi: {
    black: '#000',
    red: '#f00',
    green: '#0f0',
    yellow: '#ff0',
    blue: '#00f',
    magenta: '#f0f',
    cyan: '#0ff',
    white: '#fff',
    brightBlack: '#111',
    brightRed: '#f11',
    brightGreen: '#1f1',
    brightYellow: '#ff1',
    brightBlue: '#11f',
    brightMagenta: '#f1f',
    brightCyan: '#1ff',
    brightWhite: '#fff'
  }
}

describe('parseExtensionManifest — structural validation', () => {
  it('rejects a non-object', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      const r = parseExtensionManifest(bad, 'my-pack')
      expect(r.ok).toBe(false)
    }
  })

  it('rejects a missing/empty id', () => {
    const r = parseExtensionManifest({ label: 'My pack' }, 'my-pack')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/id/i)
  })

  it('rejects an id that does not match its folder name (anti-spoof)', () => {
    const r = parseExtensionManifest({ id: 'other', label: 'My pack' }, 'my-pack')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/folder/i)
  })

  it('rejects a missing label', () => {
    const r = parseExtensionManifest({ id: 'my-pack' }, 'my-pack')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/label/i)
  })

  it('rejects a non-object contributes', () => {
    const r = parseExtensionManifest(
      { id: 'my-pack', label: 'My pack', contributes: 'nope' },
      'my-pack'
    )
    expect(r.ok).toBe(false)
  })

  it('accepts a minimal valid manifest, defaulting version and contributes', () => {
    const r = parseExtensionManifest({ id: 'my-pack', label: 'My pack' }, 'my-pack')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest).toEqual({
        id: 'my-pack',
        label: 'My pack',
        version: '0.0.0',
        contributesRaw: {}
      })
    }
  })

  it('accepts an explicit version + contributes block', () => {
    const r = parseExtensionManifest(
      { id: 'my-pack', label: 'My pack', version: '1.2.3', contributes: { themes: [] } },
      'my-pack'
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.manifest.version).toBe('1.2.3')
      expect(r.manifest.contributesRaw).toEqual({ themes: [] })
    }
  })
})

describe('parseThemeContributions — the 36-token contract', () => {
  it('parses a fully valid theme, namespacing its id', () => {
    const themes = parseThemeContributions(
      [{ id: 'solarized', label: 'Solarized Harnu', dark: true, tokens: validTokens }],
      'my-pack',
      'My pack'
    )
    expect(themes).toHaveLength(1)
    expect(themes[0]).toMatchObject({
      id: 'ext-my-pack-solarized',
      rawId: 'solarized',
      extensionId: 'my-pack',
      extensionLabel: 'My pack',
      label: 'Solarized Harnu',
      dark: true
    })
    expect(themes[0].tokens.bg).toBe('#111111')
    expect(themes[0].tokens.ansi.brightWhite).toBe('#fff')
  })

  it('drops a theme missing a single UI token, without a reason callback throwing', () => {
    const { textDisabled: _drop, ...missingOne } = validTokens
    const rejected: string[] = []
    const themes = parseThemeContributions(
      [{ id: 'broken', label: 'Broken', dark: true, tokens: missingOne }],
      'my-pack',
      'My pack',
      (r) => rejected.push(r)
    )
    expect(themes).toHaveLength(0)
    expect(rejected).toHaveLength(1)
  })

  it('drops a theme missing a single ANSI token', () => {
    const { brightWhite: _drop, ...ansiMissing } = validTokens.ansi
    const themes = parseThemeContributions(
      [
        { id: 'broken', label: 'Broken', dark: true, tokens: { ...validTokens, ansi: ansiMissing } }
      ],
      'my-pack',
      'My pack'
    )
    expect(themes).toHaveLength(0)
  })

  it('one broken theme never disables a sibling valid theme in the same array', () => {
    const themes = parseThemeContributions(
      [
        { id: 'good', label: 'Good', dark: true, tokens: validTokens },
        { id: 'bad', label: 'Bad', dark: true, tokens: { ...validTokens, bg: undefined } }
      ],
      'my-pack',
      'My pack'
    )
    expect(themes.map((t) => t.rawId)).toEqual(['good'])
  })

  it('rejects a non-boolean "dark" and a non-string "label"', () => {
    expect(
      parseThemeContributions([{ id: 'x', label: 'X', dark: 'yes', tokens: validTokens }], 'p', 'P')
    ).toHaveLength(0)
    expect(
      parseThemeContributions([{ id: 'x', label: 42, dark: true, tokens: validTokens }], 'p', 'P')
    ).toHaveLength(0)
  })

  it('returns [] for a non-array contributes.themes', () => {
    expect(parseThemeContributions(undefined, 'p', 'P')).toEqual([])
    expect(parseThemeContributions({}, 'p', 'P')).toEqual([])
  })
})

describe('parseBoardTemplateContributions', () => {
  it('accepts known CardKind keys with non-empty string paths', () => {
    const out = parseBoardTemplateContributions({ bug: './templates/bug.md', feature: './f.md' })
    expect(out).toEqual({ bug: './templates/bug.md', feature: './f.md' })
  })

  it('drops an unknown kind key, keeping the valid ones', () => {
    const rejected: string[] = []
    const out = parseBoardTemplateContributions({ bug: './bug.md', notAKind: './x.md' }, (r) =>
      rejected.push(r)
    )
    expect(out).toEqual({ bug: './bug.md' })
    expect(rejected).toHaveLength(1)
  })

  it('drops a non-string path value', () => {
    const out = parseBoardTemplateContributions({ bug: 42 })
    expect(out).toEqual({})
  })

  it('returns {} for a non-object input', () => {
    expect(parseBoardTemplateContributions(undefined)).toEqual({})
    expect(parseBoardTemplateContributions([])).toEqual({})
  })
})

/**
 * T138 — Extension SDK Phase 2, `contributes.modes`. `doc` is kept as the RAW
 * relative path (unresolved) here — the registry fold resolves it against the
 * extension's own directory, mirroring `boardTemplates` (a whole file, not an
 * inline object like `themes`). Namespacing (`ext-<extensionId>-<rawId>`)
 * mirrors `parseThemeContributions` so an extension mode can never collide
 * with a builtin (`learning`) or a sibling extension's mode.
 */
describe('parseModeContributions', () => {
  it('parses a fully valid mode, namespacing its id', () => {
    const modes = parseModeContributions(
      [
        {
          id: 'code-reviewer',
          label: 'Code reviewer',
          icon: 'shield-check',
          doc: './modes/code-reviewer.md'
        }
      ],
      'my-pack',
      'My pack'
    )
    expect(modes).toHaveLength(1)
    expect(modes[0]).toEqual({
      id: 'ext-my-pack-code-reviewer',
      rawId: 'code-reviewer',
      extensionId: 'my-pack',
      extensionLabel: 'My pack',
      label: 'Code reviewer',
      icon: 'shield-check',
      doc: './modes/code-reviewer.md'
    })
  })

  it('defaults a missing icon to an empty string (renderer falls back)', () => {
    const modes = parseModeContributions([{ id: 'x', label: 'X', doc: './x.md' }], 'p', 'P')
    expect(modes[0].icon).toBe('')
  })

  it('drops an entry missing a required field, without disabling a valid sibling', () => {
    const rejected: string[] = []
    const modes = parseModeContributions(
      [
        { id: 'good', label: 'Good', doc: './good.md' },
        { id: 'bad', label: 'Bad' /* no doc */ }
      ],
      'my-pack',
      'My pack',
      (r) => rejected.push(r)
    )
    expect(modes.map((m) => m.rawId)).toEqual(['good'])
    expect(rejected).toHaveLength(1)
  })

  it('rejects a non-string doc, a non-string label, and a bad id', () => {
    expect(parseModeContributions([{ id: 'x', label: 'X', doc: 42 }], 'p', 'P')).toHaveLength(0)
    expect(parseModeContributions([{ id: 'x', label: 42, doc: './x.md' }], 'p', 'P')).toHaveLength(
      0
    )
    expect(
      parseModeContributions([{ id: 'bad id!', label: 'X', doc: './x.md' }], 'p', 'P')
    ).toHaveLength(0)
  })

  it('rejects a non-string icon', () => {
    expect(
      parseModeContributions([{ id: 'x', label: 'X', doc: './x.md', icon: 42 }], 'p', 'P')
    ).toHaveLength(0)
  })

  it('returns [] for a non-array contributes.modes', () => {
    expect(parseModeContributions(undefined, 'p', 'P')).toEqual([])
    expect(parseModeContributions({}, 'p', 'P')).toEqual([])
  })
})
