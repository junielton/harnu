import { describe, it, expect, vi } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Hardening suite for the settings persistence layer (OSS-readiness): a
 * renderer-supplied path must not be able to escape the allowed roots, and a
 * write patch must drop any key outside the known settings shape so a buggy or
 * compromised renderer can't smuggle arbitrary keys onto disk.
 */

// settings.ts imports `electron` at module top; stub it so the pure helpers are
// importable without an Electron runtime.
vi.mock('electron', () => ({
  app: { getPath: (): string => os.tmpdir() },
  dialog: {},
  shell: {},
  ipcMain: { handle: (): void => {} }
}))

import { isPathWithinRoot, isPathAllowed, sanitizePatch } from '../src/main/settings'

describe('settings path containment', () => {
  const root = path.resolve('/home/user/.config/Harnu')

  it('accepts the settings.json directly inside an allowed root', () => {
    expect(isPathWithinRoot(path.join(root, 'settings.json'), root)).toBe(true)
  })

  it('accepts a nested path inside an allowed root', () => {
    expect(isPathWithinRoot(path.join(root, 'nested', 'settings.json'), root)).toBe(true)
  })

  it('rejects a path that escapes the allowed root via ..', () => {
    expect(isPathWithinRoot(path.join(root, '..', '..', 'etc', 'passwd'), root)).toBe(false)
  })

  it('rejects an absolute path outside the allowed root', () => {
    expect(isPathWithinRoot('/etc/passwd', root)).toBe(false)
  })

  it('rejects a sibling whose name only prefixes the root', () => {
    // `/home/user/.config/Harnu-evil` must not be treated as inside `.../Harnu`.
    expect(isPathWithinRoot(root + '-evil/settings.json', root)).toBe(false)
  })

  it('isPathAllowed accepts when any one of several roots contains the path', () => {
    const userData = path.resolve('/home/user/.config/Harnu')
    const reloc = path.resolve('/home/user/Dropbox/harnu')
    expect(isPathAllowed(path.join(reloc, 'settings.json'), [userData, reloc])).toBe(true)
    expect(isPathAllowed('/tmp/evil/settings.json', [userData, reloc])).toBe(false)
  })
})

describe('settings sanitizePatch', () => {
  it('strips unknown keys, persisting only the known shape', () => {
    const out = sanitizePatch({
      terminalFontSize: 14,
      evil: 'rm -rf',
      __proto__: { polluted: true },
      anotherUnknown: 42
    } as Record<string, unknown>)
    expect(out).toEqual({ terminalFontSize: 14 })
    expect('evil' in out).toBe(false)
    expect('anotherUnknown' in out).toBe(false)
  })

  it('clamps the font size into the allowed bounds and rounds', () => {
    expect(sanitizePatch({ terminalFontSize: 1000 })).toEqual({ terminalFontSize: 32 })
    expect(sanitizePatch({ terminalFontSize: 1 })).toEqual({ terminalFontSize: 8 })
    expect(sanitizePatch({ terminalFontSize: 13.6 })).toEqual({ terminalFontSize: 14 })
  })

  it('drops a non-numeric font size rather than persisting garbage', () => {
    expect(sanitizePatch({ terminalFontSize: 'big' } as Record<string, unknown>)).toEqual({})
    expect(sanitizePatch({ terminalFontSize: NaN })).toEqual({})
  })

  it('clamps uiZoom into [0.5, 2] and snaps to 2 decimals', () => {
    expect(sanitizePatch({ uiZoom: 5 })).toEqual({ uiZoom: 2 })
    expect(sanitizePatch({ uiZoom: 0.1 })).toEqual({ uiZoom: 0.5 })
    expect(sanitizePatch({ uiZoom: 1.25 })).toEqual({ uiZoom: 1.25 })
    expect(sanitizePatch({ uiZoom: 1.234 })).toEqual({ uiZoom: 1.23 })
  })

  it('drops a non-numeric uiZoom rather than persisting garbage', () => {
    expect(sanitizePatch({ uiZoom: 'big' } as Record<string, unknown>)).toEqual({})
    expect(sanitizePatch({ uiZoom: NaN })).toEqual({})
  })

  it('sanitizes terminalFontSize and uiZoom together, still dropping unknowns', () => {
    expect(
      sanitizePatch({ terminalFontSize: 14, uiZoom: 1.1, evil: 'x' } as Record<string, unknown>)
    ).toEqual({ terminalFontSize: 14, uiZoom: 1.1 })
  })

  it('returns an empty patch for an empty input', () => {
    expect(sanitizePatch({})).toEqual({})
  })
})
