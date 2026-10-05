import { describe, it, expect } from 'vitest'
import {
  buildExtensionRegistry,
  type ScannedExtension
} from '../src/main/extensions/extension-registry'

const validTokens = {
  bg: '#111',
  sidebar: '#111',
  surface: '#111',
  surface2: '#111',
  border: '#111',
  border2: '#111',
  text: '#eee',
  text2: '#eee',
  text3: '#eee',
  text4: '#eee',
  textDisabled: '#eee',
  accent: '#7aa2f7',
  accentSoft: 'rgba(0,0,0,.1)',
  accentLine: 'rgba(0,0,0,.3)',
  accentInk: '#000',
  green: '#0f0',
  greenSoft: 'rgba(0,255,0,.1)',
  red: '#f00',
  redSoft: 'rgba(255,0,0,.1)',
  warning: '#fa0',
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

function manifest(id: string, contributes: Record<string, unknown> = {}): unknown {
  return { id, label: `Label for ${id}`, version: '1.0.0', contributes }
}

/**
 * T137 — pure fold from scanned extension folders into the flat registry the
 * theme store + `loadBoardTemplate` consume. Invariants pinned:
 *
 *  - an unreadable/invalid-JSON extension (raw: undefined) is skipped;
 *  - a structurally-invalid manifest drops the WHOLE extension, logged;
 *  - themes from every valid extension are concatenated;
 *  - board template paths resolve against the extension's OWN dir;
 *  - two extensions contributing the SAME board-template kind: last in scan
 *    order wins (the shell sorts by folder name before calling in).
 */
describe('buildExtensionRegistry', () => {
  it('returns an empty registry for no extensions', () => {
    const reg = buildExtensionRegistry([])
    expect(reg.themes).toEqual([])
    expect(reg.boardTemplates.size).toBe(0)
  })

  it('skips an extension whose manifest.json failed to parse (raw: undefined)', () => {
    const scanned: ScannedExtension[] = [{ id: 'broken', dirPath: '/ext/broken', raw: undefined }]
    const rejected: string[] = []
    const reg = buildExtensionRegistry(scanned, (r) => rejected.push(r))
    expect(reg.themes).toEqual([])
    expect(rejected).toEqual([]) // unreadable JSON is the shell's concern, already logged there
  })

  it('drops a whole extension on a structurally invalid manifest, logging the reason', () => {
    const scanned: ScannedExtension[] = [
      { id: 'spoofed', dirPath: '/ext/spoofed', raw: { id: 'other-id', label: 'X' } }
    ]
    const rejected: string[] = []
    const reg = buildExtensionRegistry(scanned, (r) => rejected.push(r))
    expect(reg.themes).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatch(/folder/i)
  })

  it('folds themes from multiple valid extensions', () => {
    const scanned: ScannedExtension[] = [
      {
        id: 'pack-a',
        dirPath: '/ext/pack-a',
        raw: manifest('pack-a', {
          themes: [{ id: 'a-theme', label: 'A Theme', dark: true, tokens: validTokens }]
        })
      },
      {
        id: 'pack-b',
        dirPath: '/ext/pack-b',
        raw: manifest('pack-b', {
          themes: [{ id: 'b-theme', label: 'B Theme', dark: false, tokens: validTokens }]
        })
      }
    ]
    const reg = buildExtensionRegistry(scanned)
    expect(reg.themes.map((t) => t.id)).toEqual(['ext-pack-a-a-theme', 'ext-pack-b-b-theme'])
  })

  it("a broken theme in one extension never disables that extension's board templates", () => {
    const scanned: ScannedExtension[] = [
      {
        id: 'pack-a',
        dirPath: '/ext/pack-a',
        raw: manifest('pack-a', {
          themes: [{ id: 'broken', label: 'Broken', dark: true, tokens: {} }],
          boardTemplates: { bug: './templates/bug.md' }
        })
      }
    ]
    const reg = buildExtensionRegistry(scanned)
    expect(reg.themes).toEqual([])
    expect(reg.boardTemplates.get('bug')).toEqual({
      extensionId: 'pack-a',
      absolutePath: '/ext/pack-a/templates/bug.md'
    })
  })

  it("resolves a board template path against the extension's own directory", () => {
    const scanned: ScannedExtension[] = [
      {
        id: 'pack-a',
        dirPath: '/home/user/.claude/capy-extensions/pack-a',
        raw: manifest('pack-a', { boardTemplates: { feature: './templates/feature.md' } })
      }
    ]
    const reg = buildExtensionRegistry(scanned)
    expect(reg.boardTemplates.get('feature')?.absolutePath).toBe(
      '/home/user/.claude/capy-extensions/pack-a/templates/feature.md'
    )
  })

  it('last extension in scan order wins on a board-template kind collision', () => {
    const scanned: ScannedExtension[] = [
      {
        id: 'pack-a',
        dirPath: '/ext/pack-a',
        raw: manifest('pack-a', { boardTemplates: { bug: './a.md' } })
      },
      {
        id: 'pack-b',
        dirPath: '/ext/pack-b',
        raw: manifest('pack-b', { boardTemplates: { bug: './b.md' } })
      }
    ]
    const reg = buildExtensionRegistry(scanned)
    expect(reg.boardTemplates.get('bug')).toEqual({
      extensionId: 'pack-b',
      absolutePath: '/ext/pack-b/b.md'
    })
  })

  // T138 — Extension SDK Phase 2, contributes.modes.
  it('returns an empty modes array when no extensions are scanned', () => {
    expect(buildExtensionRegistry([]).modes).toEqual([])
  })

  it('folds modes from a valid extension, resolving doc against its own dir', () => {
    const scanned: ScannedExtension[] = [
      {
        id: 'pack-a',
        dirPath: '/ext/pack-a',
        raw: manifest('pack-a', {
          modes: [{ id: 'reviewer', label: 'Reviewer', doc: './modes/reviewer.md' }]
        })
      }
    ]
    const reg = buildExtensionRegistry(scanned)
    expect(reg.modes).toHaveLength(1)
    expect(reg.modes[0]).toMatchObject({
      id: 'ext-pack-a-reviewer',
      extensionId: 'pack-a',
      extensionLabel: 'Label for pack-a',
      label: 'Reviewer'
    })
    expect(reg.modes[0].docPath).toBe('/ext/pack-a/modes/reviewer.md')
  })

  it("a broken mode in one extension never disables that extension's themes", () => {
    const scanned: ScannedExtension[] = [
      {
        id: 'pack-a',
        dirPath: '/ext/pack-a',
        raw: manifest('pack-a', {
          modes: [{ id: 'bad' /* no label/doc */ }],
          themes: [{ id: 'good-theme', label: 'Good', dark: true, tokens: validTokens }]
        })
      }
    ]
    const reg = buildExtensionRegistry(scanned)
    expect(reg.modes).toEqual([])
    expect(reg.themes).toHaveLength(1)
  })

  it('folds modes from multiple valid extensions', () => {
    const scanned: ScannedExtension[] = [
      {
        id: 'pack-a',
        dirPath: '/ext/pack-a',
        raw: manifest('pack-a', { modes: [{ id: 'a-mode', label: 'A Mode', doc: './a.md' }] })
      },
      {
        id: 'pack-b',
        dirPath: '/ext/pack-b',
        raw: manifest('pack-b', { modes: [{ id: 'b-mode', label: 'B Mode', doc: './b.md' }] })
      }
    ]
    const reg = buildExtensionRegistry(scanned)
    expect(reg.modes.map((m) => m.id)).toEqual(['ext-pack-a-a-mode', 'ext-pack-b-b-mode'])
  })
})
